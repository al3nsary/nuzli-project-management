/**
 * The custom RTL Gantt (brief §6.1/§6.4, ADR-016/017/077): React + SVG, no third-party chart.
 *
 * - Task grid on the right, timeline on the left; time flows right → left.
 * - One vertical scroller (the timeline body) drives the grid; rows are virtualised (fixed
 *   height, visible rows + overscan) and the SVG only covers the visible window of rows and days.
 * - Drag a bar to move it (left = later), drag its left edge to change its end, drag the round
 *   handle onto another bar to add a finish-to-start link. While dragging, `@nuzli/scheduling`
 *   runs locally for an instant preview of every shifted successor; the drag-end sends one batch.
 * - Keyboard: ↑/↓ rows, Enter opens, ←/→ expand/collapse (RTL), Alt+←/→ one working day later/earlier.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { toDayNumber } from '@nuzli/scheduling';
import type { GanttDto, TaskDto } from '@nuzli/shared';
import { formatNumber, t } from '../../i18n';
import type { Digits } from '../../i18n/format';
import { riyadhToday } from '../projects/engine';
import {
  BAR_HEIGHT,
  ROW_HEIGHT,
  barFor,
  barGeometry,
  buildRows,
  dayEndX,
  dayStartX,
  dayWindow,
  dependencyPath,
  dragDeltaDays,
  projectScale,
  rowWindow,
  scrollLeftFor,
  xToDay,
  type BarGeom,
  type GanttRow,
  type Zoom,
} from './geometry';
import { gregorianRows, headerRowCount, hijriRows, dayLabel } from './timeHeader';
import {
  calendarOf,
  checkNewLink,
  engineState,
  previewMove,
  previewResize,
  previewShiftWorkingDays,
  type Preview,
} from './batch';
import classes from './Gantt.module.css';

export type GridMode = 'full' | 'compact' | 'narrow';

export interface GanttProps {
  data: GanttDto;
  zoom: Zoom;
  showHijri: boolean;
  digits: Digits;
  /** Admin (`tasks.manage`): drag, resize, link, keyboard shifts. */
  editable: boolean;
  /** A batch is in flight: interactions wait. */
  busy?: boolean;
  gridMode: GridMode;
  onOpenTask(id: string): void;
  /** Drag-end / keyboard: every task the engine changed. */
  onCommit(changes: TaskDto[]): void;
  onLink(predecessorId: string, successorId: string): void;
  /** Arabic message for a refused link (self, existing, cycle with names). */
  onLinkRefused(message: string): void;
  /** Fixed viewport for tests (jsdom has no layout). */
  viewport?: { width: number; height: number };
  /** Exposes the visible window for exports. */
  onViewChange?(view: { fromDay: number; toDay: number; firstRow: number; lastRow: number }): void;
}

type DragMode = 'move' | 'resize' | 'link';

interface DragState {
  mode: DragMode;
  task: TaskDto;
  pointerId: number;
  startX: number;
  moved: boolean;
  delta: number;
  /** Link mode: pointer position in content coordinates and the target under it. */
  px?: number;
  py?: number;
  targetId?: string | null;
}

const GRID_COLUMNS: Record<GridMode, string[]> = {
  full: ['wbs', 'name', 'start', 'end', 'duration', 'progress', 'assignee'],
  compact: ['wbs', 'name', 'assignee'],
  narrow: ['name'],
};
const COL_WIDTH: Record<string, number> = { wbs: 52, name: 230, start: 84, end: 84, duration: 52, progress: 52, assignee: 150 };

export function gridWidth(mode: GridMode): number {
  if (mode === 'narrow') return 160;
  return GRID_COLUMNS[mode].reduce((s, c) => s + COL_WIDTH[c]!, 0);
}

const HEADER_ROW = 24;

export function Gantt(props: GanttProps) {
  const { data, zoom, showHijri, digits, editable, busy, gridMode } = props;
  const bodyRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [view, setView] = useState({ top: 0, left: 0, width: props.viewport?.width ?? 800, height: props.viewport?.height ?? 480 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [focus, setFocus] = useState(0);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const today = toDayNumber(riyadhToday());
  const cal = useMemo(() => calendarOf(data.calendar), [data.calendar]);
  const state = useMemo(() => engineState(data, cal), [data, cal]);
  const rows = useMemo(() => buildRows(data.tasks, collapsed), [data.tasks, collapsed]);
  const rowOf = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const scale = useMemo(() => projectScale(data.tasks, zoom, today, data.project.startDate, view.width), [data.tasks, data.project.startDate, zoom, today, view.width]);
  const bars = useMemo(() => barGeometry(rows, scale, preview?.byId), [rows, scale, preview]);
  const headerHeight = HEADER_ROW * headerRowCount(showHijri, zoom);
  const totalHeight = rows.length * ROW_HEIGHT;

  // ------------------------------------------------------------ viewport and scrolling

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || props.viewport || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, width: el.clientWidth || v.width, height: el.clientHeight || v.height })));
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.viewport]);

  // First view: near today (or the project start), earlier dates to the right. On a zoom change
  // the day at the centre of the viewport stays at the centre.
  const anchored = useRef<{ project: string; zoom: Zoom; width: number } | null>(null);
  /** Until the user scrolls, a late viewport measurement (phones) re-anchors on today. */
  const userScrolled = useRef(false);
  const centerDay = useRef<number | null>(null);
  /** The scale currently laid out in the DOM (the scroll handler measures against it). */
  const laidOut = useRef<typeof scale | null>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const prev = anchored.current;
    const vw = el.clientWidth || view.width;
    if (prev && prev.project === data.project.id && prev.zoom === zoom && (userScrolled.current || Math.abs(prev.width - vw) < 2)) return;
    const reanchor = prev && prev.zoom === zoom && !userScrolled.current;
    let left: number;
    if (prev && !reanchor && prev.project === data.project.id && centerDay.current !== null) {
      left = Math.max(0, Math.min(scale.width - vw, dayStartX(scale, centerDay.current) - vw / 2));
    } else {
      const anchor = Math.max(toDayNumber(data.project.startDate), Math.min(today, scale.endDay));
      left = scrollLeftFor(scale, anchor, vw);
    }
    anchored.current = { project: data.project.id, zoom, width: vw };
    laidOut.current = scale;
    const apply = () => {
      el.scrollLeft = left;
      // Read back the real (clamped) position so the rendered window matches what is on screen.
      const actual = el.scrollLeft;
      // When the whole chart fits, the viewport centre says nothing: keep the previous one.
      if (scale.width > vw + 2 || centerDay.current === null) centerDay.current = xToDay(scale, actual + vw / 2);
      if (headRef.current) headRef.current.scrollLeft = actual;
      setView((v) => ({ ...v, left: actual, top: el.scrollTop }));
      return actual;
    };
    // Chrome may report the previous scroll width for a few frames after a zoom change and clamp
    // the position: apply it again until the new width is in place (bounded).
    let tries = 0;
    const retry = () => {
      if (Math.abs(apply() - left) <= 1 || el.scrollWidth >= Math.floor(scale.width) || ++tries > 30) return;
      requestAnimationFrame(retry);
    };
    if (Math.abs(apply() - left) > 1) requestAnimationFrame(retry);
  }, [data.project.id, data.project.startDate, zoom, scale, today, view.width]);

  const frame = useRef(0);
  const onBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (headRef.current) headRef.current.scrollLeft = el.scrollLeft;
    if (laidOut.current && laidOut.current.width > el.clientWidth + 2) centerDay.current = xToDay(laidOut.current, el.scrollLeft + el.clientWidth / 2);
    if (gridRef.current && gridRef.current.scrollTop !== el.scrollTop) gridRef.current.scrollTop = el.scrollTop;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setView((v) => (v.top === el.scrollTop && v.left === el.scrollLeft ? v : { ...v, top: el.scrollTop, left: el.scrollLeft })));
  }, []);
  const markUserScroll = useCallback(() => {
    userScrolled.current = true;
  }, []);
  const onGridScroll = useCallback(() => {
    const g = gridRef.current;
    const b = bodyRef.current;
    if (g && b && b.scrollTop !== g.scrollTop) b.scrollTop = g.scrollTop;
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const win = rowWindow(view.top, view.height, rows.length);
  const days = dayWindow(view.left, view.width, scale);
  const { onViewChange } = props;
  useEffect(() => {
    onViewChange?.({ fromDay: days.fromDay, toDay: days.toDay, firstRow: win.first, lastRow: win.last });
  }, [onViewChange, days.fromDay, days.toDay, win.first, win.last]);

  // ------------------------------------------------------------ drag

  const contentPoint = (e: { clientX: number; clientY: number }) => {
    const el = bodyRef.current!;
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left + el.scrollLeft, y: e.clientY - r.top + el.scrollTop };
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const target = (e.target as Element).closest<SVGElement>('[data-task-id]');
    if (!target) return;
    const id = target.getAttribute('data-task-id')!;
    const handle = ((e.target as Element).closest('[data-handle]')?.getAttribute('data-handle') ?? 'move') as DragMode;
    const task = data.tasks.find((x) => x.id === id);
    if (!task) return;
    const r = rowOf.get(id);
    if (r) setFocus(r.index);
    if (!editable || busy) {
      // Read-only: a click still opens the task.
      dragRef.current = { mode: 'move', task, pointerId: e.pointerId, startX: e.clientX, moved: false, delta: 0 };
      setDrag(dragRef.current);
    } else {
      const p = contentPoint(e);
      const d: DragState = { mode: handle, task, pointerId: e.pointerId, startX: e.clientX, moved: false, delta: 0, px: p.x, py: p.y, targetId: null };
      dragRef.current = d;
      setDrag(d);
    }
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const moved = d.moved || Math.abs(dx) > 3 || d.mode === 'link';
    if (!editable || busy) {
      if (moved !== d.moved) setDrag({ ...d, moved });
      return;
    }
    if (d.mode === 'link') {
      const p = contentPoint(e);
      const row = rows[Math.floor(p.y / ROW_HEIGHT)];
      const next = { ...d, moved: true, px: p.x, py: p.y, targetId: row && row.id !== d.task.id ? row.id : null };
      dragRef.current = next;
      setDrag(next);
      return;
    }
    const delta = dragDeltaDays(dx, scale.dayWidth);
    if (delta === d.delta && moved === d.moved) return;
    const next = { ...d, moved, delta };
    dragRef.current = next;
    setDrag(next);
    // The engine runs locally: the preview shows every shifted successor.
    setPreview(d.mode === 'resize' ? previewResize(state, d.task, delta) : previewMove(state, d.task, delta));
  };

  const finishDrag = (commit: boolean) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    const p = preview;
    setPreview(null);
    if (!d || !commit) return;
    if (!d.moved) {
      props.onOpenTask(d.task.id);
      return;
    }
    if (!editable || busy) return;
    if (d.mode === 'link') {
      if (!d.targetId) return;
      const check = checkNewLink(state, d.task.id, d.targetId);
      if (check.ok) props.onLink(d.task.id, d.targetId);
      else props.onLinkRefused(linkMessage(check.reason, check.path, data.tasks));
      return;
    }
    if (p && p.changes.length) props.onCommit(p.changes);
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    finishDrag(true);
  };

  useEffect(() => {
    if (!drag) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') finishDrag(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ------------------------------------------------------------ keyboard (grid)

  const toggle = useCallback((id: string, open?: boolean) => {
    setCollapsed((c) => {
      const next = new Set(c);
      const isCollapsed = next.has(id);
      if (open === true || (open === undefined && isCollapsed)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const scrollRowIntoView = (index: number) => {
    const b = bodyRef.current;
    if (!b) return;
    const top = index * ROW_HEIGHT;
    const height = b.clientHeight || view.height;
    if (top < b.scrollTop) b.scrollTop = top;
    else if (top + ROW_HEIGHT > b.scrollTop + height) b.scrollTop = top + ROW_HEIGHT - height;
    onBodyScroll();
  };

  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const row = rows[focus];
    if (!row) return;
    let next = focus;
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      if (!editable || busy) return;
      // RTL: left is later in time, right is earlier.
      const p = previewShiftWorkingDays(state, row.task, e.key === 'ArrowLeft' ? 1 : -1);
      if (p.changes.length) props.onCommit(p.changes);
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        next = Math.min(rows.length - 1, focus + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, focus - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      case 'PageDown':
        next = Math.min(rows.length - 1, focus + Math.max(1, Math.floor(view.height / ROW_HEIGHT) - 1));
        break;
      case 'PageUp':
        next = Math.max(0, focus - Math.max(1, Math.floor(view.height / ROW_HEIGHT) - 1));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        props.onOpenTask(row.id);
        return;
      case 'ArrowLeft': // RTL: towards the children
        if (row.hasChildren) toggle(row.id, true);
        e.preventDefault();
        return;
      case 'ArrowRight':
        if (row.hasChildren && !collapsed.has(row.id)) toggle(row.id, false);
        else if (row.task.parentId) {
          const parent = rowOf.get(row.task.parentId);
          if (parent) next = parent.index;
        }
        break;
      default:
        return;
    }
    e.preventDefault();
    setFocus(next);
    scrollRowIntoView(next);
  };

  // Keep DOM focus on the focused row once it is rendered.
  const gridHasFocus = useRef(false);
  useEffect(() => {
    if (!gridHasFocus.current) return;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-row-index="${focus}"]`);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }, [focus, win.first, win.last]);

  // ------------------------------------------------------------ render

  const visibleRows = rows.slice(win.first, win.last + 1);
  const svgX0 = Math.max(0, days.x0);
  const svgW = Math.max(1, Math.min(scale.width, days.x1) - svgX0);
  const svgY0 = win.first * ROW_HEIGHT;
  const svgH = Math.max(1, (win.last - win.first + 1) * ROW_HEIGHT);
  const cols = GRID_COLUMNS[gridMode];
  const gw = gridWidth(gridMode);

  return (
    <div className={classes.root} style={{ '--gantt-grid': `${gw}px`, '--gantt-header': `${headerHeight}px` } as CSSProperties} data-testid="gantt">
      {/* Grid (inline-start = right in RTL) */}
      <div className={classes.grid} style={{ width: gw }}>
        <div className={classes.gridHeader} role="presentation" style={{ height: headerHeight }}>
          {cols.map((c) => (
            <div key={c} className={classes.headCell} style={gridMode === 'narrow' ? { flex: 1 } : { width: COL_WIDTH[c] }}>
              {t(`gantt.col.${c}` as 'gantt.col.name')}
            </div>
          ))}
        </div>
        <div
          ref={gridRef}
          className={classes.gridBody}
          role="treegrid"
          aria-label={t('gantt.gridLabel', { name: data.project.name })}
          aria-rowcount={rows.length}
          onScroll={onGridScroll}
          onKeyDown={onGridKeyDown}
          onFocus={() => (gridHasFocus.current = true)}
          onBlur={() => (gridHasFocus.current = false)}
        >
          <div style={{ height: totalHeight, position: 'relative' }}>
            {visibleRows.map((r) => (
              <GridRow
                key={r.id}
                row={r}
                task={preview?.byId.get(r.id) ?? r.task}
                cols={cols}
                mode={gridMode}
                digits={digits}
                focused={focus === r.index}
                collapsed={collapsed.has(r.id)}
                onToggle={toggle}
                onOpen={props.onOpenTask}
                onFocusRow={setFocus}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Timeline: an LTR box with physical coordinates (ADR-077). */}
      <div className={classes.timeline} dir="ltr">
        <div ref={headRef} className={classes.timeHeader} style={{ height: headerHeight }} aria-hidden>
          <div style={{ width: scale.width, height: headerHeight, position: 'relative' }}>
            <TimeHeader scale={scale} fromDay={days.fromDay} toDay={days.toDay} x0={svgX0} width={svgW} zoom={zoom} digits={digits} showHijri={showHijri} today={today} />
          </div>
        </div>
        <div
          ref={bodyRef}
          className={classes.body}
          onScroll={onBodyScroll}
          onWheel={markUserScroll}
          onTouchStart={markUserScroll}
          onMouseDown={markUserScroll}
          onKeyDown={markUserScroll}
          data-testid="gantt-body"
        >
          <div style={{ width: scale.width, height: Math.max(totalHeight, 1), position: 'relative' }}>
            <svg
              className={classes.svg}
              style={{ left: svgX0, top: svgY0 }}
              width={svgW}
              height={svgH}
              viewBox={`${svgX0} ${svgY0} ${svgW} ${svgH}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => finishDrag(false)}
              role="img"
              aria-label={t('gantt.chartLabel')}
              data-gantt-svg
            >
              <Shading cal={cal} scale={scale} fromDay={days.fromDay} toDay={days.toDay} y0={svgY0} h={svgH} holidays={data.calendar.exceptions} />
              <RowLines first={win.first} last={win.last} x0={svgX0} w={svgW} />
              {today >= scale.startDay && today <= scale.endDay ? (
                <line className={classes.today} x1={dayStartX(scale, today) - scale.dayWidth / 2} x2={dayStartX(scale, today) - scale.dayWidth / 2} y1={svgY0} y2={svgY0 + svgH} />
              ) : null}
              <Arrows data={data} rowOf={rowOf} bars={bars} first={win.first} last={win.last} preview={preview} />
              {visibleRows.map((r) => (
                <Bar key={r.id} bar={bars[r.index]!} task={preview?.byId.get(r.id) ?? r.task} editable={editable && !busy} today={today} dragging={drag?.task.id === r.id && drag.moved} linkTarget={drag?.mode === 'link' && drag.targetId === r.id} digits={digits} />
              ))}
              {drag?.mode === 'link' && drag.moved && drag.px !== undefined ? (
                <line className={classes.linkLine} x1={bars[rowOf.get(drag.task.id)?.index ?? 0]?.endX ?? 0} y1={(rowOf.get(drag.task.id)?.index ?? 0) * ROW_HEIGHT + ROW_HEIGHT / 2} x2={drag.px} y2={drag.py} />
              ) : null}
            </svg>
          </div>
        </div>
      </div>
      {drag?.moved && drag.mode !== 'link' && preview ? (
        <div className={classes.dragTip} role="status" aria-live="polite">
          {t('gantt.dragTip', { start: dayLabel((preview.byId.get(drag.task.id) ?? drag.task).startDate, digits), end: dayLabel((preview.byId.get(drag.task.id) ?? drag.task).endDate, digits), count: formatNumber(Math.max(0, preview.changes.length - 1)) })}
        </div>
      ) : null}
    </div>
  );
}

/** «هذا الربط يصنع حلقة: أ ← ب ← ج ← أ» with task names. */
export function linkMessage(reason: 'self' | 'exists' | 'cycle', path: string[] | undefined, tasks: readonly TaskDto[]): string {
  if (reason === 'self') return t('gantt.link.self');
  if (reason === 'exists') return t('gantt.link.exists');
  const names = new Map(tasks.map((x) => [x.id, x.name]));
  return t('gantt.link.cycle', { path: (path ?? []).map((id) => names.get(id) ?? '؟').join(' ← ') });
}

// ---------------------------------------------------------------- parts

const GridRow = memo(function GridRow(p: {
  row: GanttRow;
  task: TaskDto;
  cols: string[];
  mode: GridMode;
  digits: Digits;
  focused: boolean;
  collapsed: boolean;
  onToggle(id: string): void;
  onOpen(id: string): void;
  onFocusRow(index: number): void;
}) {
  const { row, task } = p;
  const late = task.status !== 'DONE' && task.type !== 'GROUP' && task.endDate < riyadhToday();
  return (
    <div
      className={classes.row}
      role="row"
      aria-level={row.depth + 1}
      aria-expanded={row.hasChildren ? !p.collapsed : undefined}
      aria-selected={p.focused}
      aria-rowindex={row.index + 1}
      tabIndex={p.focused ? 0 : -1}
      data-row-index={row.index}
      data-row
      style={{ top: row.index * ROW_HEIGHT, height: ROW_HEIGHT }}
      onClick={() => p.onFocusRow(row.index)}
      onDoubleClick={() => p.onOpen(row.id)}
    >
      {p.cols.map((c) => {
        const style: CSSProperties = p.mode === 'narrow' ? { flex: 1, minWidth: 0 } : { width: COL_WIDTH[c] };
        switch (c) {
          case 'wbs':
            return (
              <div key={c} role="gridcell" className={`${classes.cell} mono`} style={style}>
                {task.wbs}
              </div>
            );
          case 'name':
            return (
              <div key={c} role="gridcell" className={classes.cell} style={{ ...style, paddingInlineStart: 6 + row.depth * 14 }}>
                {row.hasChildren ? (
                  <button
                    type="button"
                    className={classes.caret}
                    tabIndex={-1}
                    aria-label={p.collapsed ? t('gantt.expand') : t('gantt.collapse')}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onToggle(row.id);
                    }}
                  >
                    <span className={p.collapsed ? 'mirror-rtl' : undefined} aria-hidden>
                      {p.collapsed ? '▸' : '▾'}
                    </span>
                  </button>
                ) : (
                  <span className={classes.caretSpacer} aria-hidden />
                )}
                <button
                  type="button"
                  tabIndex={-1}
                  className={classes.name}
                  data-kind={task.type}
                  title={task.name}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onFocusRow(row.index);
                    p.onOpen(row.id);
                  }}
                >
                  {task.type === 'MILESTONE' ? <span aria-hidden className={classes.diamond} /> : null}
                  {task.name}
                </button>
                {late ? <span className={classes.lateDot} title={t('gantt.overdue')} aria-label={t('gantt.overdue')} /> : null}
              </div>
            );
          case 'start':
            return (
              <div key={c} role="gridcell" className={`${classes.cell} num`} style={style}>
                {shortDate(task.startDate, p.digits)}
              </div>
            );
          case 'end':
            return (
              <div key={c} role="gridcell" className={`${classes.cell} num`} style={style}>
                {shortDate(task.endDate, p.digits)}
              </div>
            );
          case 'duration':
            return (
              <div key={c} role="gridcell" className={`${classes.cell} num`} style={style}>
                {formatNumber(task.durationDays)}
              </div>
            );
          case 'progress':
            return (
              <div key={c} role="gridcell" className={`${classes.cell} num`} style={style}>
                {`${formatNumber(Math.round(task.progress))}٪`}
              </div>
            );
          case 'assignee':
            return (
              <div key={c} role="gridcell" className={classes.cell} style={style}>
                {task.assignee ? <Assignee a={task.assignee} /> : <span className="muted">{t('common.none')}</span>}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
});

const shortFmt = new Map<string, Intl.DateTimeFormat>();
function shortDate(iso: string, digits: Digits) {
  let f = shortFmt.get(digits);
  if (!f) {
    f = new Intl.DateTimeFormat(`ar-SA-u-ca-gregory-nu-${digits}`, { timeZone: 'UTC', day: 'numeric', month: 'short' });
    shortFmt.set(digits, f);
  }
  return f.format(new Date(`${iso}T00:00:00Z`));
}

/** Assignee with the vest band in the team colour — always with the team name. */
function Assignee({ a }: { a: NonNullable<TaskDto['assignee']> }) {
  return (
    <span className={`vest ${classes.assignee}`} style={{ '--team': a.teamColor ?? 'var(--muted)' } as CSSProperties} title={a.teamName ? `${a.fullName} — ${a.teamName}` : a.fullName}>
      <span className={classes.assigneeName}>{a.fullName}</span>
      <span className={classes.assigneeTeam}>{a.teamName ?? t('gantt.noTeam')}</span>
    </span>
  );
}

const TimeHeader = memo(function TimeHeader(p: {
  scale: ReturnType<typeof projectScale>;
  fromDay: number;
  toDay: number;
  x0: number;
  width: number;
  zoom: Zoom;
  digits: Digits;
  showHijri: boolean;
  today: number;
}) {
  const { scale } = p;
  const greg = gregorianRows(p.fromDay, p.toDay, p.zoom, p.digits);
  const hijri = p.showHijri ? hijriRows(p.fromDay, p.toDay, p.zoom, p.digits) : [];
  const h = HEADER_ROW * (2 + hijri.length);
  const row = (segs: typeof greg.top, y: number, cls: string | undefined, key: string) =>
    segs.map((s) => {
      const x1 = dayStartX(scale, s.fromDay);
      const x2 = dayEndX(scale, s.toDay);
      const w = x1 - x2;
      return (
        <g key={`${key}${s.fromDay}`}>
          <line className={classes.headSep} x1={x1} x2={x1} y1={y} y2={y + HEADER_ROW} />
          {/* A label is drawn only where it fits (≈ 6 px per character at 11 px). */}
          {s.label.length * 6 + 4 <= w ? (
            <text className={cls} x={x2 + w / 2} y={y + 16} textAnchor="middle">
              {s.label}
            </text>
          ) : null}
        </g>
      );
    });
  return (
    <svg className={classes.headerSvg} style={{ left: p.x0 }} width={p.width} height={h} viewBox={`${p.x0} 0 ${p.width} ${h}`}>
      <rect x={p.x0} y={0} width={p.width} height={h} className={classes.headBg} />
      {row(greg.top, 0, classes.headTop, 't')}
      {row(greg.bottom, HEADER_ROW, classes.headText, 'b')}
      {hijri.map((segs, i) => row(segs, HEADER_ROW * (2 + i), classes.headHijri, `h${i}`))}
      <line className={classes.headSep} x1={p.x0} x2={p.x0 + p.width} y1={HEADER_ROW} y2={HEADER_ROW} />
      {hijri.map((_, i) => (
        <line key={`hs${i}`} className={classes.headSep} x1={p.x0} x2={p.x0 + p.width} y1={HEADER_ROW * (2 + i)} y2={HEADER_ROW * (2 + i)} />
      ))}
      {p.today >= p.fromDay && p.today <= p.toDay ? (
        <rect className={classes.todayMark} x={dayEndX(scale, p.today)} width={scale.dayWidth} y={h - 4} height={4} />
      ) : null}
    </svg>
  );
});

const Shading = memo(function Shading(p: {
  cal: ReturnType<typeof calendarOf>;
  scale: ReturnType<typeof projectScale>;
  fromDay: number;
  toDay: number;
  y0: number;
  h: number;
  holidays: GanttDto['calendar']['exceptions'];
}) {
  const holidayNames = useMemo(() => new Map(p.holidays.filter((e) => !e.isWorking).map((e) => [toDayNumber(e.date), e.name])), [p.holidays]);
  const out: JSX.Element[] = [];
  let runStart: number | null = null;
  const flush = (endDay: number) => {
    if (runStart === null) return;
    out.push(<rect key={`w${runStart}`} className={classes.weekend} x={dayEndX(p.scale, endDay)} width={(endDay - runStart + 1) * p.scale.dayWidth} y={p.y0} height={p.h} />);
    runStart = null;
  };
  for (let d = p.fromDay; d <= p.toDay; d++) {
    const name = holidayNames.get(d);
    if (name) {
      flush(d - 1);
      out.push(
        <rect key={`h${d}`} className={classes.holiday} x={dayEndX(p.scale, d)} width={p.scale.dayWidth} y={p.y0} height={p.h}>
          <title>{name}</title>
        </rect>,
      );
    } else if (!p.cal.isWorkingDayNum(d)) {
      if (runStart === null) runStart = d;
    } else flush(d - 1);
  }
  flush(p.toDay);
  return <g aria-hidden>{out}</g>;
});

function RowLines({ first, last, x0, w }: { first: number; last: number; x0: number; w: number }) {
  const lines: JSX.Element[] = [];
  for (let i = first; i <= last + 1; i++) lines.push(<line key={i} className={classes.rowLine} x1={x0} x2={x0 + w} y1={i * ROW_HEIGHT} y2={i * ROW_HEIGHT} />);
  return <g aria-hidden>{lines}</g>;
}

function Arrows(p: { data: GanttDto; rowOf: Map<string, GanttRow>; bars: BarGeom[]; first: number; last: number; preview: Preview | null }) {
  const out: JSX.Element[] = [];
  for (const d of p.data.dependencies) {
    if (d.type !== 'FS') continue;
    const a = p.rowOf.get(d.predecessorId);
    const b = p.rowOf.get(d.successorId);
    if (!a || !b) continue; // inside a collapsed group
    const lo = Math.min(a.index, b.index);
    const hi = Math.max(a.index, b.index);
    if (hi < p.first || lo > p.last) continue; // fully outside the window
    const shifted = p.preview?.byId.has(d.successorId);
    out.push(<path key={d.id} className={shifted ? classes.arrowActive : classes.arrow} d={dependencyPath(p.bars[a.index]!, p.bars[b.index]!)} markerEnd="url(#nz-arrow)" />);
  }
  return (
    <g aria-hidden>
      <defs>
        <marker id="nz-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L8 4L0 8z" className={classes.arrowHead} />
        </marker>
      </defs>
      {out}
    </g>
  );
}

const Bar = memo(function Bar(p: { bar: BarGeom; task: TaskDto; editable: boolean; today: number; dragging: boolean; linkTarget: boolean; digits: Digits }) {
  const { bar, task } = p;
  const late = task.status !== 'DONE' && bar.kind !== 'group' && toDayNumber(task.endDate) < p.today;
  const label = task.assignee ? `${task.assignee.fullName}${task.assignee.teamName ? ` (${task.assignee.teamName})` : ''}` : '';
  const tip = `${task.wbs} ${task.name} — ${dayLabel(task.startDate, p.digits)} ← ${dayLabel(task.endDate, p.digits)}`;
  if (bar.kind === 'milestone') {
    const cx = (bar.startX + bar.endX) / 2;
    const cy = bar.y + bar.h / 2;
    const r = 8;
    return (
      <g data-task-id={task.id} data-bar className={`${classes.bar} ${p.dragging ? classes.dragging : ''}`} data-handle="move">
        <title>{tip}</title>
        <path d={`M${cx} ${cy - r}L${cx + r} ${cy}L${cx} ${cy + r}L${cx - r} ${cy}Z`} className={task.status === 'DONE' ? classes.milestoneDone : classes.milestone} />
        {p.editable ? <circle data-handle="link" className={classes.linkHandle} cx={cx - r - 6} cy={cy} r={5} /> : null}
      </g>
    );
  }
  if (bar.kind === 'group') {
    return (
      <g data-task-id={task.id} data-bar className={classes.bar} data-handle="move">
        <title>{tip}</title>
        <rect x={bar.x} y={bar.y} width={bar.w} height={bar.h} className={classes.group} rx={2} />
        <rect x={bar.startX - bar.progressW} y={bar.y} width={bar.progressW} height={bar.h} className={classes.groupProgress} rx={2} />
        <path d={`M${bar.x} ${bar.y + bar.h}l0 5l6 -5z`} className={classes.group} />
        <path d={`M${bar.startX} ${bar.y + bar.h}l0 5l-6 -5z`} className={classes.group} />
        {p.editable ? <circle data-handle="link" className={classes.linkHandle} cx={bar.x - 8} cy={bar.y + bar.h / 2} r={5} /> : null}
      </g>
    );
  }
  const teamColor = task.assignee?.teamColor ?? null;
  return (
    <g data-task-id={task.id} data-bar className={`${classes.bar} ${p.dragging ? classes.dragging : ''} ${p.linkTarget ? classes.linkTarget : ''}`} data-handle="move">
      <title>{tip}</title>
      <rect x={bar.x} y={bar.y} width={bar.w} height={bar.h} rx={4} className={task.status === 'DONE' ? classes.taskDone : late ? classes.taskLate : classes.task} />
      {/* Progress fills from the start edge (right) towards the end. */}
      <rect x={bar.startX - bar.progressW} y={bar.y} width={bar.progressW} height={bar.h} rx={4} className={classes.progress} />
      {teamColor ? <rect x={bar.startX - 5} y={bar.y} width={5} height={bar.h} className={classes.vest} style={{ fill: teamColor }} /> : null}
      {label && bar.w > 0 ? (
        <text className={classes.barLabel} x={bar.x - (p.editable ? 18 : 6)} y={bar.y + BAR_HEIGHT / 2 + 4} textAnchor="end">
          {label}
        </text>
      ) : null}
      {p.editable ? (
        <>
          <rect data-handle="resize" className={classes.resize} x={bar.x - 3} y={bar.y} width={8} height={bar.h} />
          <circle data-handle="link" className={classes.linkHandle} cx={bar.x - 10} cy={bar.y + bar.h / 2} r={5} />
        </>
      ) : null}
    </g>
  );
});

export { barFor };
