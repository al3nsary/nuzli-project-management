/**
 * «لوحة» (Kanban) by status with dnd-kit (brief §6.1). Admins move any task; a supervisor moves
 * only tasks assigned to them, and only the status changes (ADR-007). Keyboard: on a card,
 * ←/→ move it to the next/previous column in reading order (RTL), Enter opens it.
 */
import { useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Button, Group, SegmentedControl, Text } from '@mantine/core';
import { IconDots, IconFolder } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { can, type GanttDto, type TaskDto, type TaskStatus } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import type { useProjectWrites } from '../../api/projectWrites';
import { useAuthStore } from '../../stores/auth';
import { formatDate, formatNumber, t } from '../../i18n';
import { mergeTasks } from '../../features/gantt/batch';
import { riyadhToday } from '../../features/projects/engine';
import { useQueryClient } from '@tanstack/react-query';
import { qk4 } from '../../api/projectQueries';
import { UserAvatar } from '../../components/UserAvatar';
import { TASK_STATUSES, priorityLabel, taskStatusLabel } from './parts';
import { ConflictAlert } from './TaskDrawer';
import { TaskChatButton, type ChatCount } from '../../features/tasks/TaskChatButton';

type Writes = ReturnType<typeof useProjectWrites>;
const PAGE = 60;

export function BoardView({
  data,
  writes,
  onOpenTask,
  chatCounts,
  onOpenChat,
}: {
  data: GanttDto;
  writes: Writes;
  onOpenTask(id: string): void;
  /** A10: the chat icon on every card. */
  chatCounts?: ReadonlyMap<string, ChatCount>;
  onOpenChat?(id: string): void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const admin = can(user, 'tasks.manage');
  const [scope, setScope] = useState<'all' | 'mine'>(admin ? 'all' : 'mine');
  const [limit, setLimit] = useState<Record<string, number>>({});
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const parents = useMemo(() => new Set(data.tasks.map((x) => x.parentId).filter(Boolean)), [data.tasks]);
  const cards = useMemo(
    () => data.tasks.filter((x) => !parents.has(x.id) && x.type !== 'GROUP' && (scope === 'all' || x.assignee?.id === user?.id)),
    [data.tasks, parents, scope, user?.id],
  );
  const canMove = (task: TaskDto) => admin || (task.assignee?.id === user?.id && can(user, 'tasks.updateAssigned'));

  const move = async (task: TaskDto, status: TaskStatus) => {
    if (task.status === status || !canMove(task)) return;
    const key = qk4.gantt(data.project.id);
    const snapshot = qc.getQueryData<GanttDto>(key);
    if (snapshot) qc.setQueryData(key, mergeTasks(snapshot, [{ ...task, status }])); // optimistic
    try {
      const res = await writes.run(() => api.tasks.update(task.id, { version: task.version, status }));
      writes.merge([res.task, ...res.affected]);
      notifications.show({ color: 'ok', message: t('board.moved', { name: task.name, status: taskStatusLabel(status) }) });
    } catch (err) {
      if (snapshot) qc.setQueryData(key, snapshot); // rollback
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    const task = cards.find((x) => x.id === e.active.id);
    const status = e.over?.id as TaskStatus | undefined;
    if (task && status) void move(task, status);
  };

  const onCardKey = (e: KeyboardEvent<HTMLDivElement>, task: TaskDto) => {
    const i = TASK_STATUSES.indexOf(task.status);
    // Columns read right → left in RTL: ← is the next column.
    if (e.key === 'ArrowLeft' && i < TASK_STATUSES.length - 1) {
      e.preventDefault();
      void move(task, TASK_STATUSES[i + 1]!);
    } else if (e.key === 'ArrowRight' && i > 0) {
      e.preventDefault();
      void move(task, TASK_STATUSES[i - 1]!);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onOpenTask(task.id);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      {writes.conflict ? <ConflictAlert onRefresh={() => void writes.refresh()} /> : null}
      <Group justify="space-between" wrap="wrap" gap="xs">
        <SegmentedControl
          size="xs"
          value={scope}
          onChange={(v) => setScope(v as 'all' | 'mine')}
          data={[
            { value: 'all', label: t('board.all') },
            { value: 'mine', label: t('board.mine') },
          ]}
        />
        <Text size="xs" c="dimmed">
          {admin ? t('board.hintAdmin') : t('board.hintSupervisor')}
        </Text>
      </Group>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="nz-board" role="list" aria-label={t('board.label')}>
          {TASK_STATUSES.map((status) => {
            const items = cards.filter((x) => x.status === status);
            const shown = items.slice(0, limit[status] ?? PAGE);
            return (
              <Column key={status} status={status} count={items.length}>
                {shown.map((task) => (
                  <Card key={task.id} task={task} locked={!canMove(task)} onOpen={onOpenTask} onKey={onCardKey} chat={chatCounts?.get(task.id)} onOpenChat={onOpenChat} />
                ))}
                {items.length > shown.length ? (
                  <Button variant="subtle" size="xs" onClick={() => setLimit((l) => ({ ...l, [status]: (l[status] ?? PAGE) + PAGE }))}>
                    {t('board.more', { count: formatNumber(items.length - shown.length) })}
                  </Button>
                ) : null}
              </Column>
            );
          })}
        </div>
      </DndContext>
    </div>
  );
}

function Column({ status, count, children }: { status: TaskStatus; count: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <section ref={setNodeRef} className="nz-board-col" data-status={status} data-over={isOver} role="listitem" aria-label={taskStatusLabel(status)}>
      <header className="nz-board-head">
        <i aria-hidden />
        <h3>{taskStatusLabel(status)}</h3>
        <span className="nz-board-count num">{formatNumber(count)}</span>
      </header>
      <div className="nz-board-list">{children}</div>
    </section>
  );
}

/** Priority tag of the design: a 4px-radius chip; a finished task shows «مكتملة» in green instead. */
function TaskTag({ task }: { task: TaskDto }) {
  const done = task.status === 'DONE';
  const tone = done ? 'live' : task.priority === 'LOW' ? 'wait' : task.priority === 'MEDIUM' ? 'brand' : 'no';
  return (
    <span className={`pill ${tone}`} data-urgent={(!done && task.priority === 'URGENT') || undefined}>
      {done ? taskStatusLabel('DONE') : priorityLabel(task.priority)}
    </span>
  );
}

function Card({
  task,
  locked,
  onOpen,
  onKey,
  chat,
  onOpenChat,
}: {
  task: TaskDto;
  locked: boolean;
  onOpen(id: string): void;
  onKey(e: KeyboardEvent<HTMLDivElement>, t: TaskDto): void;
  chat?: ChatCount;
  onOpenChat?(id: string): void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id, disabled: locked });
  const late = task.status !== 'DONE' && task.endDate < riyadhToday();
  // dnd-kit gives a physical delta; the transform is applied as is (not a logical offset).
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)${isDragging ? ' rotate(3deg)' : ''}`, zIndex: 5 } : undefined;
  return (
    <div
      ref={setNodeRef}
      className="nz-board-card"
      data-locked={locked}
      data-dragging={isDragging || undefined}
      style={style}
      {...attributes}
      {...(locked ? {} : listeners)}
      role="button"
      tabIndex={0}
      aria-roledescription={locked ? undefined : t('board.cardRole')}
      aria-label={t('board.cardLabel', { name: task.name, status: taskStatusLabel(task.status) })}
      onClick={() => onOpen(task.id)}
      onKeyDown={(e) => (locked ? e.key === 'Enter' && onOpen(task.id) : onKey(e, task))}
    >
      <div className="nz-bcard-top">
        <TaskTag task={task} />
        {late ? <span className="pill no">{t('gantt.overdue')}</span> : null}
        <span className="nz-bcard-wbs mono">{task.wbs}</span>
        <IconDots size={20} className="nz-bcard-dots" aria-hidden />
      </div>
      <h4 className="nz-bcard-title nz-clamp-2">{task.name}</h4>
      {task.description ? <p className="nz-bcard-desc nz-clamp-2">{task.description}</p> : null}
      <p className="nz-bcard-due">
        {t('board.due', { date: formatDate(task.endDate) })} · {`${formatNumber(Math.round(task.progress))}٪`}
      </p>
      <div className="nz-bcard-foot">
        {task.assignee ? (
          <span className="nz-bcard-who vest" style={{ '--team': task.assignee.teamColor ?? 'var(--dim2)' } as CSSProperties}>
            <UserAvatar name={task.assignee.fullName} size={26} ring={false} />
            <span>
              <b>{task.assignee.fullName}</b>
              <i>{task.assignee.teamName ?? t('gantt.noTeam')}</i>
            </span>
          </span>
        ) : (
          <span className="nz-bcard-nobody">{t('task.unassigned')}</span>
        )}
        <span className="nz-bcard-meta">
          {onOpenChat ? <TaskChatButton taskName={task.name} chat={chat} onOpen={() => onOpenChat(task.id)} /> : null}
          <span className="nz-bcard-files" aria-label={t('board.files', { n: formatNumber(task.attachmentCount) })}>
            <IconFolder size={16} aria-hidden />
            <span className="num">{formatNumber(task.attachmentCount)}</span>
          </span>
        </span>
      </div>
    </div>
  );
}
